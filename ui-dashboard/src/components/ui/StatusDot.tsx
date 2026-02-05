import styles from './StatusDot.module.css';

interface StatusDotProps {
  status: 'active' | 'pending' | 'idle' | 'error';
  className?: string;
}

export function StatusDot({ status, className = '' }: StatusDotProps) {
  return <span className={`${styles.dot} ${styles[status]} ${className}`} />;
}
