-- Generated v28-to-v29 publication after the local credential owner has verified and retired source rows.
UPDATE schema_meta SET schema_version = 29 WHERE meta_key = 'primary' AND schema_version = 28;
