import styles from './Avatar.module.css';

interface AvatarProps {
  variant?: 'user' | 'lead' | 'worker' | 'idle';
  label: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Avatar({ variant = 'user', label, size = 'md', className = '' }: AvatarProps) {
  return (
    <div className={`${styles.avatar} ${styles[variant]} ${styles[size]} ${className}`}>
      {label.charAt(0).toUpperCase()}
    </div>
  );
}
